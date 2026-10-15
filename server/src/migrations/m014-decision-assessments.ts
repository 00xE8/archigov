// v14: assessments attach to a DECISION as well as to a review. The author of a proposed decision gathers the
// evidence the argument needs (an impact assessment, a DPIA, a cost analysis…) before submitting it for review:
// trigger or provide the assessment on the draft decision, complete it, then submit — the rows keep decision_id,
// so the association survives into the review (shown there as "on the decision") and the evidence pack.
// SQLite cannot drop NOT NULL, so the table is rebuilt: review_id becomes nullable, decision_id arrives, and a
// CHECK keeps every assessment anchored to one or the other.
export default {
  version: 14,
  sql: `
    CREATE TABLE review_assessments_v14 (
      id TEXT PRIMARY KEY,
      review_id TEXT,
      decision_id TEXT,
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
      provided INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (review_id IS NOT NULL OR decision_id IS NOT NULL)
    );
    INSERT INTO review_assessments_v14 (id, review_id, decision_id, type, title, area, requested_by, assigned_to, due_at, status, result, result_md, reference, completed_by, completed_at, waived_by, waived_reason, waived_at, stale, provided, created_at, updated_at)
      SELECT id, review_id, NULL, type, title, area, requested_by, assigned_to, due_at, status, result, result_md, reference, completed_by, completed_at, waived_by, waived_reason, waived_at, stale, provided, created_at, updated_at FROM review_assessments;
    DROP TABLE review_assessments;
    ALTER TABLE review_assessments_v14 RENAME TO review_assessments;
    CREATE INDEX IF NOT EXISTS idx_review_assessments_review ON review_assessments(review_id);
    CREATE INDEX IF NOT EXISTS idx_review_assessments_assignee ON review_assessments(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_review_assessments_decision ON review_assessments(decision_id);
  `,
};
