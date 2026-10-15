# Prompt: Add a Policy Pack

Policy packs are where domain knowledge compounds. Each is a set of governance artefacts an architecture function can adopt: standards, principles, patterns and policies with control references and, where they can be checked, rules. Good candidates include:

- NCSC CAF architecture outcomes;
- NHS DSPT;
- ISO 27001 design controls;
- PCI DSS architecture requirements;
- your sector's own expectations.

A pack lives in one file in `server/src/packs/` (Apache-2.0, DCO only).

```text
Read AGENTS.md, then server/src/packs/types.ts, server/src/packs/index.ts and
server/src/packs/dora.ts as the model to follow.

Add a policy pack for <framework or domain, e.g. "NCSC CAF architecture outcomes"> as a new file
server/src/packs/<slug>.ts:
- Start the file with the two SPDX lines every file in server/src/packs/ carries.
- Export a StandardsPack with id "<slug>", a name, a one-paragraph description of what it covers
  and what it deliberately leaves out, version "1.0.0" and lifecycle_on_import "draft".
- Write <number> items. Each item has:
  - a statement in our own words of what the architecture must do, under 600 characters;
  - a rationale, a category, a severity (critical/high/medium/low) and a radar status
    (adopt/trial/assess/hold/retire);
  - control_refs pointing at the framework's clauses, e.g. "NCSC CAF B4.a". References only:
    never copy the framework's text.
- Use the kind that fits, and keep codes unique across every existing pack (search
  server/src/packs/ first):
  - standard: STD-…;
  - principle: PRN-…, never with a rule;
  - pattern: PAT-…, with context, solution and applicability;
  - policy: POL-…, with enforcement mandatory or recommended.
- Give an item a rule only when the derived model or imported evidence can really check it. The
  rule language is under "Rule format" in README.md, and server/src/rules.ts validateRule is the
  authority. A check on resource configuration asserts on imported evidence ({"op":"evidence",
  "control": …}), never on props the collector does not normalise. Leave every other item manual
  (rule: null).
- Add the pack to PACKS in server/src/packs/index.ts.

Then run `npm test` and `npm run typecheck` in server/ and fix what fails.
server/test/packs.test.ts checks every pack automatically: codes, prefixes, references,
statement length and rules.

Change nothing outside server/src/packs/. Do not add a Signed-off-by line or run git commit -s;
I will review and sign off. Finish with a table of the items you added: code, title, kind, the
references, and whether each is checkable.
```

**Review it yourself before you sign off.** Are the statements yours rather than paraphrased control text? Do the references point at the right clauses? Is each rule checking what its statement says?
