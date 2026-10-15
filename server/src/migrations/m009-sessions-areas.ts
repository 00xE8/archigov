// v9: board sessions, areas of responsibility, positions and dependent decisions (docs/board-sessions.md).
// A board carries areas; a decision maker owns some of them; a review touches some (derived, editable). Approvals
// become positions per area (yes / no / conditional / not_my_area), resolved by the chair; the existing
// review_approvals rows are carried over as count-mode positions (approve → yes, request_changes → no, no area)
// and the old table is dropped. Sessions hold a derived agenda, attendance, one-hop delegations and derived,
// hashed minutes. Dependencies link a review to the decisions it is approved pending on.
export default {
  version: 9,
  sql: `
    ALTER TABLE boards        ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE board_members ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE reviews ADD COLUMN areas_json TEXT;
    ALTER TABLE reviews ADD COLUMN areas_derived_json TEXT;
    ALTER TABLE reviews ADD COLUMN areas_origin TEXT;
    ALTER TABLE reviews ADD COLUMN session_id TEXT;
    ALTER TABLE reviews ADD COLUMN pending_outcome TEXT;
    ALTER TABLE reviews ADD COLUMN circulation_due TEXT;
    ALTER TABLE reviews ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE reviews ADD COLUMN deferred_reason TEXT;
    ALTER TABLE reviews ADD COLUMN last_deferred_at TEXT;
    ALTER TABLE review_events ADD COLUMN session_id TEXT;
    ALTER TABLE conditions ADD COLUMN area TEXT;
    ALTER TABLE conditions ADD COLUMN position_id TEXT;

    CREATE TABLE IF NOT EXISTS review_positions (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, session_id TEXT,
      user_id TEXT NOT NULL, board_role TEXT NOT NULL, on_behalf_of TEXT, delegation_id TEXT,
      area TEXT,
      position TEXT NOT NULL,
      text TEXT, at TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
      resolution TEXT, resolution_text TEXT, resolved_by TEXT, resolved_at TEXT, resolution_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_review_positions_review ON review_positions(review_id);
    INSERT INTO review_positions(id,review_id,session_id,user_id,board_role,on_behalf_of,delegation_id,area,position,text,at,superseded)
      SELECT id, review_id, NULL, user_id, board_role, NULL, NULL, NULL,
             CASE WHEN decision='approve' THEN 'yes' ELSE 'no' END, comment, at, superseded
      FROM review_approvals;
    DROP TABLE review_approvals;

    CREATE TABLE IF NOT EXISTS board_sessions (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, board_id TEXT NOT NULL, title TEXT, scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned', created_by TEXT NOT NULL,
      opened_by TEXT, opened_at TEXT, closed_by TEXT, closed_at TEXT,
      notes_md TEXT, minutes_json TEXT, minutes_hash TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_items (
      session_id TEXT NOT NULL, review_id TEXT NOT NULL, position INTEGER NOT NULL,
      consent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'listed',
      acting_chair TEXT, called_at TEXT, outcome TEXT, declared_at TEXT, note TEXT,
      PRIMARY KEY (session_id, review_id)
    );
    CREATE TABLE IF NOT EXISTS session_attendance (
      session_id TEXT NOT NULL, user_id TEXT NOT NULL, board_role TEXT, status TEXT NOT NULL,
      on_behalf_of TEXT, recorded_by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (session_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS session_delegations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, delegator TEXT NOT NULL, delegate TEXT NOT NULL,
      areas_json TEXT NOT NULL, recorded_by TEXT NOT NULL, on_instruction INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT
    );
    CREATE TABLE IF NOT EXISTS review_dependencies (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, decision_id TEXT NOT NULL, dependency_review_id TEXT,
      created_by TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT, resolved_state TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_links (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (from_id, to_id, kind)
    );
  `,
};
