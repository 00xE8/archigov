// v12: submitter-provided assessments — the author attaches due diligence (a DPIA, an impact assessment, a scope
// statement…) to their own review as supporting information. A provided assessment arrives already recorded by its
// author (never an open request, so it never blocks) and sits beside the board-requested ones on the review, in the
// evidence pack and in the audit chain. `provided = 1` marks the flavour; everything else reuses review_assessments.
export default {
  version: 12,
  sql: `
    ALTER TABLE review_assessments ADD COLUMN provided INTEGER NOT NULL DEFAULT 0;
  `,
};
