# Prompt: Add a Policy Pack

Policy packs are where domain knowledge compounds. Each is a set of governance artefacts an architecture function can adopt: standards, principles, patterns and policies with control references and, where they can be checked, rules. Good candidates include:

- NCSC CAF architecture outcomes;
- NHS DSPT;
- ISO 27001 design controls;
- PCI DSS architecture requirements;
- your sector's own expectations.

A pack is a new file in `server/src/packs/` plus one line in `index.ts`, both Apache-2.0, needing only a DCO sign-off.

```text
Read AGENTS.md, then in server/src/packs/: types.ts, index.ts, dora.ts (standards, some
checkable) and governance-starter.ts (principles, patterns and policies). Those two files are
the models to follow.

Add a policy pack for <framework or domain, e.g. "NCSC CAF architecture outcomes">, citing <the
framework's current version, e.g. "CAF 4.0">:
- A new file server/src/packs/<short-name>.ts that starts with the two SPDX lines every file
  there carries.
- It exports a StandardsPack with:
  - id "<slug>", a name, version "1.0.0" and lifecycle_on_import "draft";
  - a one-paragraph description naming the framework version, what the pack covers and what it
    leaves out.
- Append the pack to the end of PACKS in server/src/packs/index.ts. The test pins the first
  five, so never reorder.
- Write <number> items. Each has:
  - a statement in our own words of what the architecture must do, under 600 characters;
  - a rationale, a severity (critical/high/medium/low) and a radar status
    (adopt/trial/assess/hold/retire);
  - a category (see the next point);
  - control_refs (see the last point).
- The category decides which board area must take a position on the item, so use one that maps
  to an area. The mapping is in server/src/boards/areas.ts (CATEGORY_MAP), for example:
  - Security, Data, Networking, Integration, Hosting, Infrastructure, Resilience, Backup, Cost,
    Governance, Compliance, AI;
  - an unknown category routes to no area.
- Use the kind that fits:
  - standard: STD-…;
  - principle: PRN-…, never with a rule;
  - pattern: PAT-…, with context, solution and applicability;
  - policy: POL-…, with enforcement mandatory or recommended.
- Codes follow the existing <PREFIX>-<FRAMEWORK>-NN form (e.g. STD-CAF-01) and are unique across
  every pack: search server/src/packs/ first.
- Give an item a rule only when it can really be checked. The rule language is under "Rule
  format" in README.md, and server/src/rules.ts validateRule is the authority. Follow the line
  azure-waf.ts draws:
  - A resource-configuration check (encryption, TLS, public access, purge protection…) asserts
    on imported evidence: {"op":"evidence","source":…,"control":…}.
    - Use only control keys that exist in server/src/azure/controls.ts, from the source that
      really produces them. Its header says which keys Defender for Cloud produces and which
      only Azure Policy does.
    - validateRule cannot catch an invented key: it would raise "no evidence imported" on every
      matched resource, forever.
  - An architecture property the collector derives (redundancy, region, tags, decisions, the
    application's classification app.*) may be read directly.
  - Everything else stays manual (rule: null).
- control_refs carry the framework's clause identifiers (e.g. "NCSC CAF B4.a"): references only,
  never the framework's text. When an item's rule asserts on evidence, also name that control
  the way azure-waf.ts does ("Azure Policy: storage-secure-transfer" or "Defender:
  storage-public-access"). If you are not sure an identifier is right, say so rather than guess.

Then run `npm test` and `npm run typecheck` in server/ and fix what fails.
server/test/packs.test.ts checks every pack automatically: codes, prefixes, references,
statement length, kind requirements and that rules are valid.

To see what a rule would actually find:
1. Start a scratch instance with the demo, in server/:
     DATA_DIR=$(mktemp -d) PORT=8091 npm run dev
2. Import the pack as an author:
     curl -s -X POST -H "x-user: s.patel" localhost:8091/api/standards/packs/<slug>/import
3. Dry-run each checkable item (its id comes from GET /api/artefacts?q=<code>):
     curl -s -H "x-user: s.patel" localhost:8091/api/artefacts/<id>/dry-run
   In the UI, the same answer is under Governance Catalogue → the item → Pre-review Preview.
Report what each rule would raise on the demo estate.

Change nothing outside server/src/packs/. If you commit, use a conventional message with an
Assisted-by trailer and no Signed-off-by; never run git commit -s. I will review and sign off.
Finish with a table of the items you added: code, kind, title, category, references, and whether
each is checkable (with the dry-run result).
```

**Review it yourself before you sign off:**
- Are the statements yours rather than paraphrased control text?
- Do the references point at the right clauses, in the version the pack names?
- Does each rule check what its statement says, and does the dry run agree?
