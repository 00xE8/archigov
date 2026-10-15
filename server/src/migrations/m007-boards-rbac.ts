// v7: two-level RBAC (a users table with a system user type and a separate platform-admin flag), boards with
// board roles, routing rules and per-review-type approval policies, typed reviews that carry their target and
// the board they were routed to, and the approvals that drive the workflow. Existing reviews are design reviews
// of their application; the board is filled in by boards/seed.ts once the default boards exist.
export default {
  version: 7,
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      user_type TEXT NOT NULL DEFAULT 'engineer', is_platform_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, purpose TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_members (
      board_id TEXT NOT NULL, user_id TEXT NOT NULL, board_role TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (board_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS board_routing (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, review_type TEXT NOT NULL, kind TEXT, category TEXT,
      priority INTEGER NOT NULL DEFAULT 100
    );
    CREATE TABLE IF NOT EXISTS approval_policies (
      board_id TEXT NOT NULL, review_type TEXT NOT NULL, policy_json TEXT NOT NULL,
      PRIMARY KEY (board_id, review_type)
    );
    CREATE TABLE IF NOT EXISTS review_approvals (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, user_id TEXT NOT NULL, board_role TEXT NOT NULL,
      decision TEXT NOT NULL, comment TEXT, at TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_review_approvals_review ON review_approvals(review_id);
    ALTER TABLE reviews ADD COLUMN type TEXT NOT NULL DEFAULT 'design';
    ALTER TABLE reviews ADD COLUMN target_kind TEXT;
    ALTER TABLE reviews ADD COLUMN target_id TEXT;
    ALTER TABLE reviews ADD COLUMN board_id TEXT;
    ALTER TABLE reviews ADD COLUMN impact TEXT;
    ALTER TABLE reviews ADD COLUMN resubmitted_at TEXT;
    UPDATE reviews SET target_kind='application', target_id=application_id WHERE target_kind IS NULL AND application_id IS NOT NULL;
    UPDATE reviews SET type='decision', target_kind='decision', target_id=decision_id WHERE target_kind IS NULL AND decision_id IS NOT NULL;
  `,
};
