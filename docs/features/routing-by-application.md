# Routing by application

## What it is

A routing rule can name the applications it covers: either a list of applications, or every application whose resources carry an owner tag. A review for those applications then goes to that board. This lets a team, a product line or a business unit have its own board for its own designs, decisions and exceptions. Anything no such rule claims goes where it went before: by review type, kind and category, and otherwise to the Design Authority.

## Why

Boards decide (see the thesis in `CLAUDE.md`), but until now routing split work only by **subject**: a review's type, a decision's topic, a catalogue item's kind and category. It could not split work by **owner**. All design reviews went to one board, whichever team's system they concerned, and only a chair's referral could move an item to a team's board, after it had landed elsewhere.

Routing by application adds the owner dimension and keeps the invariant: one board decides each review, and its chair declares the outcome. A small organisation needs none of it. A larger one can give each team a light board and keep the Design Authority for what crosses teams. The owner condition reads the estate, in keeping with "derived, not authored": nobody maintains a list of which team owns which application when the resources already say so.

## Heuristics and AI

No AI. Routing is deterministic:

- **Which applications a review is for.** A design or an exception names one application. A decision applies to the applications it lists. A catalogue review (standard, principle, pattern, policy) is for none.
- **When a rule covers a review.** Every one of the review's applications must be covered, either listed by the rule or carrying its owner tag on one of their resources. Owner tags compare case-insensitively. A decision that spans two teams is not covered by either team's rule, so it falls back to the general rules. A review for no application never matches a rule with an application condition.
- **Which rule wins.** The most specific matching rule wins: an application condition (4) outweighs an artefact kind (2), which outweighs a category (1). Priority breaks a tie, lowest first. With no match, the review goes to the board coded `DA`. A team's decision on a data store therefore goes to the team's board even if a Data board routes the `data-store` topic. To keep a topic central for a team, its chair refers the item up.
- **When routing applies.** Once, when the review is created; resubmission keeps the board. The owning board of a reaffirmation is routed the same way, so an accepted decision for a team's applications is reaffirmed by that team's chair.

## Who can do what

- **The platform admin, or the board's chair or secretary,** sets its routing rules, conditions included (`manages(board, "routing")`).
- **Everyone else** gets 403, including authors.
- **Authors** submit reviews as before; routing happens for them.
- **Anyone signed in** may preview where a review would go.

## API

- `PUT /boards/:id/routing [{ review_type, kind?, category?, priority?, application_ids?, owner? }]` replaces the board's rules.
  - `application_ids` and `owner` are allowed on `design`, `decision` and `exception` rules only. On another type the call is refused with 400 ("not for an application").
  - Unknown application ids get 400.
  - Response: `{ ok, board, routing }`.
- `GET /boards/:id`: every routing rule now carries `application_ids`, `applications: [{ id, name }]` and `owner`.
- `GET /boards/route?type=&kind=&category=&application=` previews the receiving board. `application` repeats, or takes a comma-separated list.

## Data & audit

- **Migration m022** adds `board_routing.application_ids_json` and `board_routing.owner`.
- **Audit:** `routing:set` on the board records `{ rules, by_application }`. Review creation still audits the board the review went to (`create` on `reviews`, `board`).
- **Evidence pack:** nothing new. Each review already records its board.

## UI

- **Board page → Decision Flow:**
  - the Routing table gains an Applications column (an owner tag, or application names, or "any");
  - the per-type workflow table names the condition ("· for owner clinical-systems").
- **Edit Routing:** design, decision and exception rules get a second line:
  - an **Applications** `FilterableMultiSelect`;
  - an **Owner tag** `Select` offering the owners found in the estate.

  The line hides for catalogue types, and saving drops the condition from them. The help text states the precedence.

## Verification

- `server/test/routing.test.ts`:
  - owners read from resource tags, case-insensitively;
  - owner and application rules;
  - an application rule beats a category rule;
  - every application of a decision must be covered;
  - catalogue routing unchanged.
- `scripts/smoke-boards.sh`, step j:
  - the PCB stands in for a team board, with owner and application rules;
  - preview, a real design review routed by owner, then withdrawn;
  - refused for catalogue types, unknown ids and authors;
  - the routing is restored afterwards.

## Not in scope

- **Two boards deciding the same review.** One board decides each review. Other groups contribute through areas, requested assessments, dependent decisions or referral.
- **Automatic escalation**, such as "after the team board, refer to the Design Authority when a critical application is touched". Today it's the chair's referral.
- **Suggesting team boards from owner tags**, and seating members from Entra groups (known gap 9).
