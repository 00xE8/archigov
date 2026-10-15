# Prompt: A Fix or a Feature in the Core

Everything outside the Apache-2.0 folders is the AGPL-3.0 core: the derived model, the rules engine, boards and reviews, evidence and audit, exporters, the web UI. A core change needs a DCO sign-off and, once, the CLA (a licence grant; you keep your copyright). For anything bigger than a fix, open an issue first, so the design is agreed before the code.

```text
Read AGENTS.md, then CLAUDE.md's "Conventions" section, then the docs/features page and the code
for the area you are changing.

<Describe the fix or the feature, with the issue number if there is one.>

Work to these rules:
- Keep the product rules in AGENTS.md: nothing asserts compliance; AI output stays a draft a
  named person promotes; boards decide; the server is the authority.
- A new endpoint gets its rule in server/src/auth/roles.ts. A new state change calls audit(). A
  schema change is one new file in server/src/migrations/.
- A fix starts with a failing test in server/test/ that the fix makes pass.
- A feature ships with docs/features/<slug>.md (sections per docs/features/README.md, including
  "Heuristics and AI") and a CHANGELOG entry under Unreleased.
- UI work: read design-system/README.md first. Compose IBM Carbon components with var(--cds-*)
  tokens, Title Case labels, and status as colour, icon and word. Verify component props and
  icon names; do not guess them.

Run `npm test`, and `npm run typecheck` in server/ and web/. If you can, start a scratch
instance (DATA_DIR=$(mktemp -d) PORT=8091 npm run dev in server/) and run the smoke script
nearest the change against it. If you commit, use a conventional message with an Assisted-by
trailer and no Signed-off-by; never run git commit -s, and never post the CLA agreement: both
are mine to do. Finish with what changed and why, how you tested it, and anything you could not
verify.
```
