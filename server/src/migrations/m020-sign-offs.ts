// v20: periodic sign-offs — the chair of the board that owns an adopted catalogue artefact or an accepted decision
// states, on a cadence, that it still holds (reaffirmed) or that it needs a revision. Each sign-off sets the next
// review date; nothing is deleted, so the history of who stood behind what, when, stays in the record.
export default {
  version: 20,
  sql: `
    CREATE TABLE IF NOT EXISTS sign_offs (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      note TEXT,
      board_id TEXT,
      signed_by TEXT NOT NULL, signed_at TEXT NOT NULL,
      next_due TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sign_offs_subject ON sign_offs(subject_kind, subject_id, signed_at);
  `,
};
