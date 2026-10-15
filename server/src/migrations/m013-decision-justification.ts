// v13: the decision record argues in three parts — Recommended Option (what we will do), Justification (why that
// option wins against the alternatives: the argument a board tests) and Consequences (what accepting it means and
// which risks are explicitly accepted). decision_md keeps the recommended option; this adds the justification.
export default {
  version: 13,
  sql: `
    ALTER TABLE decisions ADD COLUMN justification_md TEXT NOT NULL DEFAULT '';
  `,
};
