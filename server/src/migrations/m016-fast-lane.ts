// v16: the fast lane — a design review names the adopted patterns it claims to follow (patterns_json, artefact ids).
// Eligibility itself is derived on every read (boards/fastlane.ts); only the submitter's claim is stored.
export default {
  version: 16,
  sql: `
    ALTER TABLE reviews ADD COLUMN patterns_json TEXT NOT NULL DEFAULT '[]';
  `,
};
