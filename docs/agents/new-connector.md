# Prompt: Add a Connector or an Importer

Connectors collect an estate or a backlog: today Azure Resource Graph, Defender for Cloud, Azure Policy and Azure DevOps. Importers read the repositories organisations already keep: today CSV and ArchiMate. Wanted next: AWS, GCP, Jira, GitHub Issues, LeanIX, Ardoq.

**Before you start, open an issue.** A new connector or importer gets its own folder (for example `server/src/aws/`), and the folder must join the Apache-2.0 list on `main` before your pull request. The CLA check reads that list from `main`, never from your branch.

**What stays core.** The connector's own folder is Apache-2.0. Wiring it in is core (AGPL): the source kinds in `server/src/sync.ts`, the routes in `server/src/routes/integrations.ts`, and the cards in Settings · Sources. Either leave the wiring to the maintainer, or agree to the CLA for those files.

```text
Read AGENTS.md, then study the pattern in server/src/azure/:
- client.ts: auth from environment variables, throttling, paging;
- resourceGraph.ts: provider responses mapped to NormalisedResource from server/src/model.ts;
- fixtures.ts: recorded response shapes, served when ARCHIGOV_FIXTURES=1;
- server/test/azure.test.ts: tests that parse the fixtures through the real code.

Build a <provider> <connector | importer> in server/src/<folder>/, which the maintainer has
added to .github/licensing.json (issue #<n>):
- Every file starts with the two SPDX lines the Apache-2.0 folders carry.
- Read-only access, with credentials from environment variables only; never store or log a
  secret.
- Use a provider API version you have verified in the provider's documentation, and name it in a
  constant. Page through every result and respect the provider's rate limits.
- Map each item to NormalisedResource. Normalise only properties the provider really returns;
  never invent a value or a default that would read as a fact.
- Record fixtures with the real response shape and fake identifiers, and serve them when
  ARCHIGOV_FIXTURES=1. Never return evidence or state a real account could not produce.
- Add server/test/<folder>.test.ts parsing the fixtures through the real code, including paging
  and an error response.

Do not edit sync.ts, routes/ or the web UI: list what wiring is needed and I will raise it with
the maintainer. Run `npm test` and `npm run typecheck` in server/. Do not add a Signed-off-by
line or run git commit -s; I will review and sign off.
```
