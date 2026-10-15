# Feature documentation

Every feature ships with a page in this folder, in the same PR as the code. The page is the contract: what the feature does, who may do what, what lands in the audit chain and the evidence pack, and how it is verified. `docs/board-sessions.md` predates this convention and plays the same role for the board workflow.

## Convention

One file per feature, kebab-case slug (`provided-assessments.md`), linked from the CHANGELOG entry that shipped it. Sections, in order:

1. **What it is** — two or three sentences a buyer could read.
2. **Why** — the decision it serves, anchored to the thesis in `CLAUDE.md`.
3. **Who can do what** — capabilities and seats, including who is explicitly refused (403s are part of the contract).
4. **API** — routes, request/response shape in brief, notable status codes.
5. **Data & audit** — tables/migrations touched, audit actions, what the evidence pack carries.
6. **UI** — where it surfaces, which Carbon patterns it follows.
7. **Verification** — the tests and smoke scripts that pin the behaviour.

Keep it current: a PR that changes the behaviour updates the page in the same PR.
