// v10: review assessments — due diligence a board seat requests on a submission (a DPIA, a security or supplier
// assessment, a clinical-safety case…), conducted by a named assessor who records the result themselves. An open
// request blocks the approving outcomes until the result is recorded or the chair waives it with a reason; results
// are never deleted — a resubmission marks them stale (recorded against an earlier version). The `reference` is an
// external pointer (URL or document id), never the document itself.
export default {
  version: 10,
  sql: `
    CREATE TABLE IF NOT EXISTS review_assessments (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      area TEXT,
      requested_by TEXT NOT NULL,
      assigned_to TEXT NOT NULL,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      result TEXT,
      result_md TEXT,
      reference TEXT,
      completed_by TEXT, completed_at TEXT,
      waived_by TEXT, waived_reason TEXT, waived_at TEXT,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_assessments_review ON review_assessments(review_id);
    CREATE INDEX IF NOT EXISTS idx_review_assessments_assignee ON review_assessments(assigned_to);
  `,
};
