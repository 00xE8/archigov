# Prompt: Improve or Add an Assessment Template

Assessment templates are the headings a competent assessment result answers: a DPIA, a security, supplier, clinical-safety or AI-impact assessment, an accessibility audit. They live in `server/src/templates/assessments.ts` (Apache-2.0, DCO only).

**Improving an existing template** touches only that file. **A new assessment type** also needs a label in `web/src/api.ts`, which is core (AGPL). Either leave that line for the maintainer and say so in the pull request, or agree to the CLA.

```text
Read AGENTS.md and server/src/templates/assessments.ts.

<Improve the "<type>" template | Add an assessment type "<type>" for <what it assesses>> so that
it asks for what a competent <type> assessment answers:
- Markdown "## " headings, each followed by a blank line or by one short prompt line that says
  what belongs there.
- Prompts for the assessor's own content only. Reference a framework by name and clause where it
  helps (e.g. "DCB0129"), never copy its text.
- Keep it to the headings a reviewer needs; no boilerplate. If you add a type, add it to
  ASSESSMENT_TYPES and ASSESSMENT_TEMPLATES only; do not edit web/src/api.ts. Tell me which
  label it needs.

Run `npm test` and `npm run typecheck` in server/. Change nothing outside server/src/templates/.
If you commit, use a conventional message with an Assisted-by trailer and no Signed-off-by;
never run git commit -s; I will review and sign off.
```
