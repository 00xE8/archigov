// v21: the risk register — architecture risks with an owner, a severity and a review date: those a decision accepts
// (decision_id; their standing follows the decision), and those logged on their own. Exceptions are accepted risks
// too, but they are read from the exceptions table, never copied here.
export default {
  version: 21,
  sql: `
    CREATE TABLE IF NOT EXISTS risks (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT,
      review_by TEXT,
      source TEXT NOT NULL,
      decision_id TEXT,
      application_ids_json TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL DEFAULT 'human',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      closed_by TEXT, closed_at TEXT, closure_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_risks_decision ON risks(decision_id);
  `,
};
