// v18: exit plans are register assessments (kind exit_plan, subject = the provider) with details a legacy assessment
// does not have — substitutability (DORA ITS B_07.01) and when the plan was last tested (PRA SS2/21 ch. 10).
export default {
  version: 18,
  sql: `
    ALTER TABLE register_assessments ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
  `,
};
